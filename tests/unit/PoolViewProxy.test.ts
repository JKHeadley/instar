/**
 * Tier-1 tests for WS4.4 PoolViewProxy (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4
 * a/c/d) — holder resolution by fan-out probe, the concurrency cap, and the
 * honest offline-holder verdict. Deterministic clock; injected probe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PoolViewProxy, type PoolPeer } from '../../src/core/PoolViewProxy.js';

const SELF = 'm_self';
const VIEW = 'view-1';

let nowMs: number;
beforeEach(() => { nowMs = 1_000_000; });

function makeProxy(over: {
  heldLocally?: (v: string) => boolean;
  peers?: PoolPeer[];
  probe?: (p: PoolPeer, v: string) => Promise<'present' | 'absent' | 'unreachable'>;
  maxConcurrent?: number;
  resolveMemoTtlMs?: number;
  cpuLoadPerCore?: () => number;
  loadShedLoadPerCore?: number;
}) {
  return new PoolViewProxy({
    selfMachineId: SELF,
    heldLocally: over.heldLocally ?? (() => false),
    listPeers: () => over.peers ?? [],
    probePeer: over.probe ?? (async () => 'absent'),
    now: () => nowMs,
    maxConcurrent: over.maxConcurrent,
    resolveMemoTtlMs: over.resolveMemoTtlMs,
    cpuLoadPerCore: over.cpuLoadPerCore,
    loadShedLoadPerCore: over.loadShedLoadPerCore,
  });
}

describe('PoolViewProxy — holder resolution (a: view-id ownership ≠ topic ownership)', () => {
  it('resolves LOCAL when this machine holds the view (no probe)', async () => {
    let probed = false;
    const p = makeProxy({ heldLocally: () => true, probe: async () => { probed = true; return 'present'; } });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'local' });
    expect(probed).toBe(false);
  });

  it('resolves REMOTE to the peer that answers present', async () => {
    const peers: PoolPeer[] = [
      { machineId: 'm_a', url: 'http://a', online: true },
      { machineId: 'm_b', url: 'http://b', online: true },
    ];
    const p = makeProxy({
      peers,
      probe: async (peer) => (peer.machineId === 'm_b' ? 'present' : 'absent'),
    });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'remote', machineId: 'm_b', url: 'http://b' });
  });

  it('resolves NOT-FOUND when every reachable peer answers absent', async () => {
    const peers: PoolPeer[] = [{ machineId: 'm_a', url: 'http://a', online: true }];
    const p = makeProxy({ peers, probe: async () => 'absent' });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'not-found' });
  });

  it('resolves NO-PEERS on a single-machine pool', async () => {
    const p = makeProxy({ peers: [] });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'no-peers' });
  });

  it('skips self in the peer list', async () => {
    const peers: PoolPeer[] = [{ machineId: SELF, url: 'http://self', online: true }];
    const p = makeProxy({ peers });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'no-peers' });
  });

  it('memoizes a resolution within the TTL (no re-fan-out)', async () => {
    let probes = 0;
    const peers: PoolPeer[] = [{ machineId: 'm_a', url: 'http://a', online: true }];
    const p = makeProxy({ peers, probe: async () => { probes++; return 'present'; } });
    await p.resolveHolder(VIEW);
    await p.resolveHolder(VIEW);
    expect(probes).toBe(1);
  });

  it('invalidate() forces a fresh fan-out', async () => {
    let probes = 0;
    const peers: PoolPeer[] = [{ machineId: 'm_a', url: 'http://a', online: true }];
    const p = makeProxy({ peers, probe: async () => { probes++; return 'present'; } });
    await p.resolveHolder(VIEW);
    p.invalidate(VIEW);
    await p.resolveHolder(VIEW);
    expect(probes).toBe(2);
  });
});

describe('PoolViewProxy — offline holder (d: honest unavailable, never bare 404)', () => {
  it('a known-offline peer is treated as unreachable → holder-offline (not not-found)', async () => {
    let probed = false;
    const peers: PoolPeer[] = [{ machineId: 'm_off', url: 'http://off', online: false }];
    const p = makeProxy({ peers, probe: async () => { probed = true; return 'absent'; } });
    const r = await p.resolveHolder(VIEW);
    expect(r).toEqual({ kind: 'holder-offline', machineId: 'm_off' });
    expect(probed).toBe(false); // an offline peer is never probed
  });

  it('a probe that throws/times out yields holder-offline (the holder may be unreachable)', async () => {
    const peers: PoolPeer[] = [{ machineId: 'm_x', url: 'http://x', online: true }];
    const p = makeProxy({ peers, probe: async () => { throw new Error('timeout'); } });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'holder-offline', machineId: 'm_x' });
  });

  it('a present online peer wins even if another peer is unreachable (no false offline)', async () => {
    const peers: PoolPeer[] = [
      { machineId: 'm_dead', url: 'http://dead', online: true },
      { machineId: 'm_live', url: 'http://live', online: true },
    ];
    const p = makeProxy({
      peers,
      probe: async (peer) => (peer.machineId === 'm_live' ? 'present' : 'unreachable'),
    });
    expect(await p.resolveHolder(VIEW)).toEqual({ kind: 'remote', machineId: 'm_live', url: 'http://live' });
  });
});

describe('PoolViewProxy — concurrency cap (c: bounded in-flight, never an unbounded queue)', () => {
  it('admits up to maxConcurrent and sheds the next with at-capacity', async () => {
    const p = makeProxy({ maxConcurrent: 2 });
    let release1!: () => void;
    let release2!: () => void;
    const f1 = p.withSlot(() => new Promise<string>((r) => { release1 = () => r('a'); }));
    const f2 = p.withSlot(() => new Promise<string>((r) => { release2 = () => r('b'); }));
    // Both slots taken — the third is shed immediately.
    expect(p.inFlightCount).toBe(2);
    const shed = await p.withSlot(async () => 'c');
    expect(shed).toEqual({ ok: false, reason: 'at-capacity' });
    // Release one; a new slot opens.
    release1();
    await f1;
    expect(p.inFlightCount).toBe(1);
    const admitted = await p.withSlot(async () => 'd');
    expect(admitted).toEqual({ ok: true, value: 'd' });
    release2();
    await f2;
    expect(p.inFlightCount).toBe(0);
  });

  it('decrements in-flight even when fn throws', async () => {
    const p = makeProxy({ maxConcurrent: 1 });
    await expect(p.withSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(p.inFlightCount).toBe(0);
  });
});

describe('PoolViewProxy — load-shed staleness tag (f: over-CPU serves last-cached, honestly labeled)', () => {
  const PEERS: PoolPeer[] = [
    { machineId: 'm_a', url: 'http://a', online: true },
    { machineId: 'm_b', url: 'http://b', online: true },
  ];

  it('under threshold → a fresh fan-out, returned stale:false', async () => {
    const p = makeProxy({
      peers: PEERS,
      probe: async (peer) => (peer.machineId === 'm_b' ? 'present' : 'absent'),
      cpuLoadPerCore: () => 0.5,
      loadShedLoadPerCore: 1.5,
    });
    const t = await p.resolveHolderTagged(VIEW);
    expect(t.stale).toBe(false);
    expect(t.resolution).toEqual({ kind: 'remote', machineId: 'm_b', url: 'http://b' });
  });

  it('OVER threshold WITH a (now-expired) cached resolution → serves last-cached flagged stale, ZERO re-fan-out', async () => {
    let load = 0.2;
    let probes = 0;
    const p = makeProxy({
      peers: PEERS,
      resolveMemoTtlMs: 1_000,
      probe: async (peer) => { probes++; return peer.machineId === 'm_b' ? 'present' : 'absent'; },
      cpuLoadPerCore: () => load,
      loadShedLoadPerCore: 1.5,
    });
    // Calm: populate the memo fresh.
    const fresh = await p.resolveHolderTagged(VIEW);
    expect(fresh.stale).toBe(false);
    const probesAfterFresh = probes;
    // Spike CPU AND expire the memo. Load-shed must serve the STALE cache, no probe.
    load = 2.5;
    nowMs += 2_000;
    const shed = await p.resolveHolderTagged(VIEW);
    expect(shed.resolution).toEqual({ kind: 'remote', machineId: 'm_b', url: 'http://b' });
    expect(shed.stale).toBe(true);
    expect(shed.cachedAtMs).toBe(fresh.cachedAtMs);
    expect(probes).toBe(probesAfterFresh); // the load-shed: no new fan-out
  });

  it('OVER threshold WITHOUT any cache → load-shed kind, never fabricates, never probes', async () => {
    let probes = 0;
    const p = makeProxy({
      peers: PEERS,
      probe: async () => { probes++; return 'absent'; },
      cpuLoadPerCore: () => 3.0,
      loadShedLoadPerCore: 1.5,
    });
    const t = await p.resolveHolderTagged(VIEW);
    expect(t.resolution).toEqual({ kind: 'load-shed' });
    expect(t.stale).toBe(false);
    expect(probes).toBe(0);
  });

  it('local-held views are NEVER load-shed (free to resolve even at high CPU)', async () => {
    const p = makeProxy({
      heldLocally: () => true,
      cpuLoadPerCore: () => 9.0,
      loadShedLoadPerCore: 1.5,
    });
    expect(await p.resolveHolderTagged(VIEW)).toEqual({ resolution: { kind: 'local' }, stale: false, cachedAtMs: nowMs });
  });

  it('threshold 0 disables load-shed (always fans out fresh)', async () => {
    let probes = 0;
    const p = makeProxy({
      peers: PEERS,
      probe: async (peer) => { probes++; return peer.machineId === 'm_b' ? 'present' : 'absent'; },
      cpuLoadPerCore: () => 9.0,
      loadShedLoadPerCore: 0,
    });
    const t = await p.resolveHolderTagged(VIEW);
    expect(t.stale).toBe(false);
    expect(t.resolution.kind).toBe('remote');
    expect(probes).toBeGreaterThan(0);
  });

  it('no CPU sampler → never load-sheds (fresh fan-out)', async () => {
    let probes = 0;
    const p = makeProxy({
      peers: PEERS,
      probe: async (peer) => { probes++; return peer.machineId === 'm_b' ? 'present' : 'absent'; },
    });
    const t = await p.resolveHolderTagged(VIEW);
    expect(t.stale).toBe(false);
    expect(t.resolution.kind).toBe('remote');
    expect(probes).toBeGreaterThan(0);
  });
});
